import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectionList } from "../../../shared/organizer/CollectionList";
import { createDemoSnapshot } from "../../../shared/domain";
import { MemoryWorkspaceRepository } from "../../../shared/repository";
import "../../../shared/organizer/organizer.css";

const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
function Fixture() {
  const [snapshot, setSnapshot] = useState(createDemoSnapshot);
  return <main style={{ padding: 24, width: 760 }}><CollectionList collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={async () => setSnapshot(await repository.load())} /></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
