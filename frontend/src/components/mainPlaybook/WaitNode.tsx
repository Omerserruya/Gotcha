"use client";
import { CollapsedNode } from "./CollapsedNode";
import { NodeProps } from "reactflow";
export function WaitNode(props: NodeProps) { return <CollapsedNode {...props} />; }
