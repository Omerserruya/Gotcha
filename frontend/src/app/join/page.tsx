"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { acceptPublicInvite, getPublicInvite } from "@/lib/api";

export default function JoinPage() {
  return (
    <Suspense fallback={<Loading />}>
      <JoinContent />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full" />
    </div>
  );
}

interface InviteShape {
  tenant: { name: string; slug: string };
  email: string | null;
  role: string;
  requiresPassword: boolean;
}

function JoinContent() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params?.get("token") || "";

  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InviteShape | null>(null);
  const [loadError, setLoadError] = useState<string>("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setLoadError("This invite link is missing a token. Ask your admin for a new link.");
      return;
    }
    setLoading(true);
    getPublicInvite(token)
      .then((res) => {
        setInvite(res.data);
        if (res.data.email) setEmail(res.data.email);
      })
      .catch((err) => {
        setLoadError(err?.message || "This invite link is invalid or has expired.");
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function handleAccept(e: FormEvent) {
    e.preventDefault();
    if (!token || !invite) return;
    setAccepting(true);
    setAcceptError("");
    try {
      await acceptPublicInvite({
        token,
        name: name.trim(),
        email: invite.email ? undefined : email.trim().toLowerCase(),
        password,
      });
      router.replace(`/login?email=${encodeURIComponent(invite.email || email)}&tenant=${encodeURIComponent(invite.tenant.slug)}&fromInvite=1`);
    } catch (err: any) {
      setAcceptError(err?.message || "Couldn't accept invite. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  if (loading) return <Loading />;

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-7 text-center space-y-3">
          <h1 className="text-xl font-bold text-gray-900">Invite unavailable</h1>
          <p className="text-sm text-gray-500">{loadError}</p>
          <a href="/login" className="inline-block mt-2 px-4 py-2 text-sm text-primary-600 hover:text-primary-700">Go to login</a>
        </div>
      </div>
    );
  }

  if (!invite) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="max-w-md w-full">
        <form
          onSubmit={handleAccept}
          className="bg-white rounded-2xl shadow-lg border border-gray-100 p-7 space-y-5"
        >
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Join {invite.tenant.name}</h1>
            <p className="text-sm text-gray-500 mt-1">
              Set up your account to start collaborating with the team.
            </p>
          </div>

          {acceptError && (
            <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{acceptError}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={!!invite.email}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm disabled:bg-gray-100 disabled:text-gray-500"
            />
            {invite.email && (
              <p className="mt-1 text-xs text-gray-400">Email is fixed for this invite.</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition text-sm"
            />
            <p className="mt-1 text-xs text-gray-400">Minimum 8 characters.</p>
          </div>

          <button
            type="submit"
            disabled={accepting || !name.trim() || !email.trim() || password.length < 8}
            className="w-full py-3 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition disabled:opacity-50 shadow-lg shadow-primary-500/25"
          >
            {accepting ? "Joining…" : "Join workspace"}
          </button>

          <p className="text-center text-xs text-gray-400">
            Already have an account?{" "}
            <a href={`/login?tenant=${encodeURIComponent(invite.tenant.slug)}`} className="text-primary-600 hover:text-primary-700">
              Log in
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
