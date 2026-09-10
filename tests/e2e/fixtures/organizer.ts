import type { WorkspaceSnapshot } from "../../../shared/domain";

export const organizerIds = {
  space: "10000000-0000-4000-8000-000000000001",
  otherSpace: "10000000-0000-4000-8000-000000000002",
  plan: "20000000-0000-4000-8000-000000000001",
  build: "20000000-0000-4000-8000-000000000002",
  research: "20000000-0000-4000-8000-000000000003",
};

export function organizerSnapshot(): WorkspaceSnapshot {
  const base = { user_id: "local-user", origin: "saved" as const, read_only: false, created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z" };
  return {
    spaces: [
      { ...base, id: organizerIds.space, name: "Product launch", color: "#7157d9", position: 0 },
      { ...base, id: organizerIds.otherSpace, name: "Research and references with a deliberately long space name", color: "#d94f5a", position: 1 },
    ],
    collections: [
      { ...base, id: organizerIds.plan, space_id: organizerIds.space, name: "Plan", position: 0 },
      { ...base, id: organizerIds.build, space_id: organizerIds.space, name: "Build", position: 1 },
      { ...base, id: organizerIds.research, space_id: organizerIds.otherSpace, name: "References", position: 0 },
    ],
    links: [
      ["Product roadmap", organizerIds.plan, 0],
      ["Customer brief", organizerIds.plan, 1],
      ["Launch checklist", organizerIds.build, 0],
      ["Cross-space reference", organizerIds.research, 0],
    ].map(([title, collectionId, position], index) => ({ ...base, id: `30000000-0000-4000-8000-00000000000${index + 1}`, collection_id: String(collectionId), title: String(title), position: Number(position), url: `https://acceptance.example/${index}`, description: "", favicon_url: null, device_label: null })),
  };
}
