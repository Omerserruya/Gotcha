#!/usr/bin/env bash
#
# Does the inbox's sort key agree with the messages it is supposed to order?
#
# WHY THIS IS A SCRIPT AND NOT A NUMBER IN A COMMIT MESSAGE
#
# Asked "how many conversations would change position under the SENT-branch key",
# the answer on 2026-09-27 was ZERO - but zero because of WHICH rows happened to
# be stale, not because a correction could never cross a neighbour. The dataset's
# tightest margin was SMALLER than the largest correction present in it. That
# makes the answer a property of one dataset at one moment, and quoting it after a
# reseed would be quoting a measurement of data that no longer exists.
#
# So it is re-runnable, and it EXITS NON-ZERO when any conversation would move.
#
# Read-only. Every statement is a SELECT.
#
# Usage:  tools/sort-key-drift.sh
#         DB_SERVICE=db DB_NAME=whatsapp_cc tools/sort-key-drift.sh
set -uo pipefail

DB_SERVICE="${DB_SERVICE:-db}"
DB_NAME="${DB_NAME:-whatsapp_cc}"
DB_USER="${DB_USER:-postgres}"
# Read-only what-if. 0 = measure reality.
EXTRA_DRIFT_S="${SIMULATE_EXTRA_DRIFT_S:-0}"
case "$EXTRA_DRIFT_S" in ''|*[!0-9.]*) echo "SIMULATE_EXTRA_DRIFT_S must be a number" >&2; exit 2;; esac

psql_q() { docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

# The eligible population is what the INBOX shows: live origin, sandbox
# rehearsals excluded, a key to sort by. Measuring anything wider would report
# drift on rows no agent ever sees.
read -r -d '' SCOPE <<'SQL' || true
with newest as (
  select m.conversation_id, max(m.created_at) as newest_real
  from messages m
  where m.conversation_id is not null and m.status <> 'FAILED'
  group by m.conversation_id
), k as (
  select c.id,
         c.last_message_at as old_key,
         n.newest_real,
         -- SIMULATE_EXTRA_DRIFT_S pushes the corrected key further ahead, for the
         -- rows that are actually behind. It writes nothing; it exists so the
         -- tripwire below can be PROVEN to fire rather than assumed to. Run it
         -- above the movable-row headroom and this script must exit 1.
         case when n.newest_real > c.last_message_at
              then greatest(c.last_message_at, n.newest_real)
                   + make_interval(secs => __EXTRA_DRIFT__)
              else greatest(c.last_message_at, n.newest_real) end as new_key
  from conversations c
  join newest n on n.conversation_id = c.id
  where c.origin = 'LIVE'
    and c.last_message_at is not null
    and (c.customer_external_id is null or c.customer_external_id not like 'sandbox:%')
)
SQL
SCOPE="${SCOPE//__EXTRA_DRIFT__/$EXTRA_DRIFT_S}"

echo "── Where each key sits relative to its own newest non-FAILED message"
echo "   AHEAD by milliseconds = a writer that stamped the CLOCK."
echo "   exact                 = a writer that used the ROW's createdAt."
echo "   After the SENT-branch change, new rows should land in 'exact'."
psql_q -c "
$SCOPE
select case when new_key > old_key then 'BEHIND (would be corrected)'
            when old_key = newest_real then 'exact'
            else 'AHEAD of its messages' end as bucket,
       count(*),
       round(min(abs(extract(epoch from (old_key - newest_real))))::numeric,3) as min_gap_s,
       round(max(abs(extract(epoch from (old_key - newest_real))))::numeric,3) as max_gap_s
from k group by 1 order by 2 desc;"

echo "── Would any conversation change position? (ordered as the inbox orders)"
psql_q -c "
$SCOPE
, r as (
  select id,
         row_number() over (order by old_key desc, id desc) as old_rank,
         row_number() over (order by new_key desc, id desc) as new_rank
  from k
)
select count(*) as ranked,
       count(*) filter (where old_rank <> new_rank) as would_move,
       coalesce(max(abs(old_rank - new_rank)),0) as largest_move_places
from r;"

echo "── Headroom: how much MORE drift before the FIRST reorder appears"
echo "   Two numbers, and the SECOND is the one that matters."
echo "   The tightest pair anywhere is usually between rows that never move, so it"
echo "   understates the margin. Only a row being CORRECTED can cross a neighbour."
echo "   Compare 'rows_that_can_move' against max_gap_s above: that difference is"
echo "   the real margin, and if it is negative a zero result is coincidence."
psql_q -c "
$SCOPE
select round(min(h_all)::numeric,3)     as headroom_any_pair_s,
       round(min(h_movable)::numeric,3) as headroom_rows_that_can_move_s
from (
  select extract(epoch from (
           (select min(o.new_key) from k o where o.new_key > k.new_key) - k.new_key
         )) as h_all,
         case when k.new_key > k.old_key then extract(epoch from (
           (select min(o.new_key) from k o where o.new_key > k.new_key) - k.new_key
         )) end as h_movable
  from k
) h;"

MOVERS=$(psql_q -t -A -c "
$SCOPE
, r as (
  select id,
         row_number() over (order by old_key desc, id desc) as old_rank,
         row_number() over (order by new_key desc, id desc) as new_rank
  from k
)
select count(*) from r where old_rank <> new_rank;" 2>/dev/null | tr -d '[:space:]')

if [ -z "$MOVERS" ]; then
  echo "!! could not read a result - is the '$DB_SERVICE' service up?" >&2
  exit 2
fi
if [ "$MOVERS" != "0" ]; then
  echo "!! $MOVERS conversation(s) would change position in the inbox." >&2
  echo "   A capture taken across this change will differ, and that is expected" >&2
  echo "   rather than a tear. Re-read before assuming a rendering fault." >&2
  exit 1
fi
if [ "$EXTRA_DRIFT_S" != "0" ]; then
  echo "OK - still no movement WITH ${EXTRA_DRIFT_S}s of simulated extra drift."
else
  echo "OK - no conversation changes position on this dataset, at this moment."
fi
