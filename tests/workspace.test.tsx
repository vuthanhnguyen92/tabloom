import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

describe("WorkspaceClient", () => {
  it("filters links from the global search field", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.type(screen.getByLabelText("Search your links"), "figma");
    expect(screen.getByText("Brand system")).toBeInTheDocument();
    expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument();
  });

  it("creates a valid link in the selected collection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getAllByRole("button", { name: "Add link" })[0]);
    await user.type(screen.getByLabelText("Link title"), "Reference");
    await user.type(screen.getByLabelText("Link URL"), "https://example.com/reference");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(screen.getByText("Reference")).toBeInTheDocument());
  });

  it("rejects unsupported link protocols", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getAllByRole("button", { name: "Add link" })[0]);
    await user.type(screen.getByLabelText("Link title"), "Unsafe");
    await user.clear(screen.getByLabelText("Link URL"));
    await user.type(screen.getByLabelText("Link URL"), "chrome://settings");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("http");
  });

  it("renames spaces and collections", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Rename Product launch space" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Launch HQ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findAllByText("Launch HQ")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Rename Plan collection" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Strategy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Strategy")).toBeInTheDocument();
  });

  it("moves links between collections with accessible controls", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const user = userEvent.setup();
    render(<WorkspaceClient repository={repository} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Move Product roadmap to next collection" }));
    await waitFor(async () => {
      const snapshot = await repository.load();
      expect(snapshot.links.find((link) => link.title === "Product roadmap")?.collection_id).toBe("collection-design");
    });
  });
});
