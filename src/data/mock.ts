export type Engine = "exo" | "Ollama" | "Claude" | "LM Studio" | "OpenRouter";

export type Project = {
  id: string;
  name: string;
  count: number;
};

export type Conversation = {
  id: string;
  title: string;
  engine: Engine;
  time: string;
  bucket: "today" | "yesterday" | "older";
  projectId?: string;
};

export type MessageStats = {
  ttft: string;
  tokens: number;
  speed: string;
  ctx: string;
  cost: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  stats?: MessageStats;
};

export const projects: Project[] = [
  { id: "p1", name: "Thecomp.ai product", count: 24 },
  { id: "p2", name: "Audiobook pipeline", count: 11 },
  { id: "p3", name: "Research notes", count: 7 },
];

export const conversations: Conversation[] = [
  {
    id: "c1",
    title: "Distributed inference benchmarks",
    engine: "exo",
    time: "14:32",
    bucket: "today",
  },
  {
    id: "c2",
    title: "Extract engine interface",
    engine: "Ollama",
    time: "11:02",
    bucket: "today",
  },
  {
    id: "c3",
    title: "Q3 strategy note",
    engine: "Claude",
    time: "09:48",
    bucket: "today",
  },
  {
    id: "c4",
    title: "Voxtral prompt engineering",
    engine: "exo",
    time: "08:15",
    bucket: "today",
  },
  {
    id: "c5",
    title: "PDF summarization",
    engine: "exo",
    time: "",
    bucket: "yesterday",
  },
  {
    id: "c6",
    title: "Docker compose for air-gap",
    engine: "Ollama",
    time: "",
    bucket: "yesterday",
  },
  {
    id: "c7",
    title: "Node memory pressure",
    engine: "LM Studio",
    time: "",
    bucket: "yesterday",
  },
];

export const messages: Message[] = [
  {
    id: "m1",
    role: "user",
    content:
      "Compare distributed inference speed on 4 Mac Studios vs 2 Mac Studios for a 70B model. What's the expected TTFT and tok/s in each case?",
  },
  {
    id: "m2",
    role: "assistant",
    content: `Good question — the trade-off here is between memory bandwidth per node and interconnect overhead. On 4 Mac Studios with full mesh Thunderbolt 5 RDMA, you distribute the 70B weights across 4× M4 Ultra = roughly 35 GB of active weights per node (bf16). TTFT lands around 850ms, sustained throughput is typically 38–42 tok/s.

On 2 Mac Studios, you double the weights per node (~70 GB each) but halve the interconnect hops. TTFT drops to around 600ms, but sustained throughput is lower — around 28–32 tok/s — because each node becomes more memory-bandwidth-bound during autoregressive decoding.

The 4-node setup wins on throughput; the 2-node setup wins on latency. For interactive chat I'd pick 2 nodes; for batch workloads, 4.`,
    stats: {
      ttft: "742ms",
      tokens: 248,
      speed: "41.3 tok/s",
      ctx: "1,842 / 128k",
      cost: "$0.00 · local",
    },
  },
];
