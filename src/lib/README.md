# lib

Small, focused, dependency-free utilities. Empty by design.

A helper belongs here only when it is used by more than one layer and has no
domain meaning - date arithmetic, a string comparator. Anything with domain
meaning belongs in `domain/`, and anything used once belongs beside its caller.

This is explicitly not a `utils.ts` dumping ground. If a file here grows past
one clear responsibility, it needs a name and a home of its own.
