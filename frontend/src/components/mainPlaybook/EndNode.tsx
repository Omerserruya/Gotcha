"use client";
import { CollapsedNode } from "./CollapsedNode";
import { NodeProps } from "reactflow";
export function EndNode(props: NodeProps) { return <CollapsedNode {...props} />; }
