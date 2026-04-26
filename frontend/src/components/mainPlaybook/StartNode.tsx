"use client";
import { CollapsedNode } from "./CollapsedNode";
import { NodeProps } from "reactflow";
export function StartNode(props: NodeProps) { return <CollapsedNode {...props} />; }
