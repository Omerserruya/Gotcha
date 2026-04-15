"use client";

import { use } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import CustomerTimeline from "@/components/CustomerTimeline";

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token } = useAuth();
  if (!token) return null;
  return (
    <AppLayout>
      <div className="p-6">
        <h1 className="text-xl font-semibold text-gray-900 mb-4">Customer Timeline</h1>
        <CustomerTimeline token={token} contactId={id} />
      </div>
    </AppLayout>
  );
}
