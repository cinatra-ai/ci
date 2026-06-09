// Positive control: recharts is the allowed shadcn chart primitive, used
// well beyond the dashboards code — it must NOT be banned and must NOT be
// scoped to the Drizzle Cube carve-out. This file sits outside every
// carve-out on purpose. Expected: zero reports.
import { Line, LineChart, ResponsiveContainer } from "recharts";

export function UsageChart({ data }: { data: Array<{ value: number }> }) {
  return (
    <ResponsiveContainer>
      <LineChart data={data}>
        <Line dataKey="value" />
      </LineChart>
    </ResponsiveContainer>
  );
}
