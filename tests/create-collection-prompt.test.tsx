import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CreateCollectionPrompt } from "../extension/CreateCollectionPrompt";
import { createLocalWorkspaceRepository } from "../extension/storage";

function memoryArea() {
  const state: Record<string, unknown> = {};
  return {
    get: async (key: string) => ({ [key]: state[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(state, value); },
  };
}

describe("CreateCollectionPrompt", () => {
  it("creates a named collection in the active space and closes the modal", async () => {
    const repository = await createLocalWorkspaceRepository(memoryArea());
    const initial = await repository.load();
    render(<header style={{ transform: "translateY(0)" }}>
      <CreateCollectionPrompt
        activeSpaceId={initial.spaces[0].id}
        repository={repository}
        onCreated={async () => undefined}
        onError={() => undefined}
      />
    </header>);

    await userEvent.click(screen.getByRole("button", { name: "New collection" }));
    expect(screen.getByRole("dialog", { name: "Create a collection" }).closest("header")).toBeNull();
    const input = screen.getByRole("textbox", { name: "Collection name" });
    expect(screen.getByRole("button", { name: "Create collection" })).toBeDisabled();

    await userEvent.type(input, "Project links");
    await userEvent.click(screen.getByRole("button", { name: "Create collection" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create a collection" })).not.toBeInTheDocument());
    expect((await repository.load()).collections.map((item) => item.name)).toEqual(["My Collection", "Project links"]);
  });
});
