"use client";

import { useEffect, useState } from "react";
import { getPolicy as fetchPolicy, updatePolicy, BusinessPolicy } from "@/lib/gotcha-api";

interface Props {
  token: string;
}

/**
 * F8.4 — Minimal Business Policy admin surface.
 * Reads + writes GET/PUT /api/ai-assist/policy. Admin-only; the backend
 * enforces the role check so this component doesn't need to.
 */
export default function PolicyAdmin({ token }: Props) {
  const [policy, setPolicyState] = useState<BusinessPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchPolicy(token);
        setPolicyState(res.data);
      } catch (e: any) {
        setError(e?.message ?? "failed to load policy");
      }
    })();
  }, [token]);

  async function save() {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updatePolicy(token, policy);
      setPolicyState(res.data);
    } catch (e: any) {
      setError(e?.message ?? "failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  if (!policy) return <div>Loading policy...</div>;

  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, maxWidth: 480 }}>
      <strong>Business Policy</strong>
      {error && <div style={{ color: "crimson" }}>{error}</div>}
      <label style={{ display: "block", marginTop: 8 }}>
        Max discount %
        <input
          type="number"
          min={0}
          max={100}
          value={policy.maxDiscountPercent}
          onChange={(e) =>
            setPolicyState({ ...policy, maxDiscountPercent: Number(e.target.value) })
          }
          style={{ marginLeft: 8, width: 80 }}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={policy.refundRequiresApproval}
          onChange={(e) => setPolicyState({ ...policy, refundRequiresApproval: e.target.checked })}
        />
        Refund requires approval
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Escalation keywords (comma-separated)
        <input
          type="text"
          value={policy.escalationKeywords.join(", ")}
          onChange={(e) =>
            setPolicyState({
              ...policy,
              escalationKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
            })
          }
          style={{ width: "100%" }}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Blocked topics (comma-separated)
        <input
          type="text"
          value={policy.blockedTopics.join(", ")}
          onChange={(e) =>
            setPolicyState({
              ...policy,
              blockedTopics: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
            })
          }
          style={{ width: "100%" }}
        />
      </label>
      <button onClick={save} disabled={saving} style={{ marginTop: 12 }}>
        {saving ? "Saving..." : "Save policy"}
      </button>
    </div>
  );
}
