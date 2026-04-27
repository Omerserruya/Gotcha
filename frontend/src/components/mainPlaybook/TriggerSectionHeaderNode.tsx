"use client";

import React from "react";
import { NodeProps } from "reactflow";

export function TriggerSectionHeaderNode(props: NodeProps) {
  const label = String(props.data?.label ?? "");
  return (
    <div
      className="select-none pointer-events-none"
      style={{ width: 280 }}
    >
      <span className="text-[11px] font-semibold tracking-wide text-gray-500">
        {label}
      </span>
    </div>
  );
}
