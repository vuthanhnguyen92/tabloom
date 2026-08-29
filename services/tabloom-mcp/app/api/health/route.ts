export function GET() {
  return Response.json(
    { service: "tabloom-mcp", status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
