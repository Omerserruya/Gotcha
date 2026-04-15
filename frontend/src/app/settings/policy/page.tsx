"use client";

import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import PolicyAdmin from "@/components/PolicyAdmin";

export default function PolicyAdminPage() {
  const { token } = useAuth();
  if (!token) return null;
  return (
    <AppLayout>
      <div className="p-6">
        <h1 className="text-xl font-semibold text-gray-900 mb-4">Business Policy</h1>
        <PolicyAdmin token={token} />
      </div>
    </AppLayout>
  );
}
