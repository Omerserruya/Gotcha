"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { getDepartments } from "@/lib/api";

export function HandoverNode({ data }: NodeProps) {
  const { token } = useAuth();
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [departmentId, setDepartmentId] = useState<string>(data.departmentId || "");

  useEffect(() => {
    if (!token) return;
    getDepartments(token).then((res) => {
      setDepartments(res.data || []);
    }).catch(() => {});
  }, [token]);

  function handleChange(id: string) {
    setDepartmentId(id);
    data.departmentId = id;
  }

  const selectedDept = departments.find((d) => d.id === departmentId);
  const description = selectedDept ? `Transfers to ${selectedDept.name}` : "Transfers to human agent";

  return (
    <div className="bg-white rounded-2xl shadow-lg shadow-sky-100/40 border border-sky-200/60 min-w-[220px] ring-1 ring-sky-100/50 transition-shadow hover:shadow-xl hover:shadow-sky-100/50">
      <Handle type="target" position={Position.Top} className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-r from-sky-500 to-sky-600 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
        </div>
        Handover to Agent
      </div>
      <div className="p-3 space-y-2">
        <select
          value={departmentId}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full text-xs border border-sky-200/60 bg-sky-50/30 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-sky-400/30 focus:border-sky-300 outline-none transition"
        >
          <option value="">Any available agent</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>{dept.name}</option>
          ))}
        </select>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <svg className="w-3.5 h-3.5 text-sky-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
          {description}
        </div>
      </div>
    </div>
  );
}
