import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CollectionShareDialog } from "../shared/CollectionShareDialog";
import { GlobalSearch } from "../shared/organizer/GlobalSearch";
import { webOrganizerCapabilities } from "../shared/organizer/capabilities";
import type {
  CollectionShare,
  CollectionShareRepository,
  ShareAvailability,
} from "../shared/collection-sharing";
import type { Collection } from "../shared/domain";

const collection: Collection = {
  id: "20000000-0000-4000-8000-000000000001",
  user_id: "user-1",
  space_id: "space-1",
  name: "Design references",
  position: 0,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
  origin: "saved",
  read_only: false,
};

const firstShare: CollectionShare = {
  collectionId: collection.id,
  token: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const replacementShare: CollectionShare = {
  ...firstShare,
  token: "123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
  updatedAt: "2026-09-04T00:01:00.000Z",
};

function createRepository(active: CollectionShare | null = null): CollectionShareRepository {
  return {
    get: vi.fn(async () => active),
    enable: vi.fn(async () => firstShare),
    regenerate: vi.fn(async () => replacementShare),
    disable: vi.fn(async () => undefined),
  };
}

function renderDialog(options: {
  availability?: ShareAvailability;
  repository?: CollectionShareRepository | null;
} = {}) {
  const props = {
    availability: options.availability ?? "ready" as const,
    collection,
    onClose: vi.fn(),
    onRequestSignIn: vi.fn(),
    onRequestSyncRetry: vi.fn(),
    onToast: vi.fn(),
    repository: options.repository === undefined ? createRepository() : options.repository,
    siteUrl: "https://tabloom.nickvu.dev",
  };
  render(<CollectionShareDialog {...props} />);
  return props;
}

describe("CollectionShareDialog", () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])("owns modal focus and excludes search shortcuts for %j", async (modifier) => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><GlobalSearch snapshot={{ spaces: [], collections: [], links: [] }} capabilities={webOrganizerCapabilities({ openUrl: async () => {} })} />
        <button onClick={() => setOpen(true)}>Share collection</button>
        {open && <CollectionShareDialog availability="offline" collection={collection} repository={null} siteUrl="https://tabloom.nickvu.dev" onRequestSignIn={vi.fn()} onRequestSyncRetry={vi.fn()} onToast={vi.fn()} onClose={() => setOpen(false)} />}
      </>;
    }
    const { container } = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Share collection" });
    await userEvent.click(trigger);
    fireEvent.keyDown(window, { key: "f", ...modifier });
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
    expect(container).toHaveAttribute("inert");
    const close = screen.getByRole("button", { name: "Close sharing" });
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(container).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it("loads an unshared collection and enables its live URL", async () => {
    const repository = createRepository();
    renderDialog({ repository });

    expect(screen.getByRole("dialog", { name: "Share Design references" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Enable sharing" }));

    expect(await screen.findByDisplayValue(`https://tabloom.nickvu.dev/s/${firstShare.token}`)).toBeVisible();
    expect(repository.enable).toHaveBeenCalledWith(collection.id);
  });

  it("copies the active URL and emits compact feedback", async () => {
    const props = renderDialog({ repository: createRepository(firstShare) });
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `https://tabloom.nickvu.dev/s/${firstShare.token}`,
    );
    expect(props.onToast).toHaveBeenCalledWith("Share link copied");
  });

  it("requires confirmation before replacing the active URL", async () => {
    const repository = createRepository(firstShare);
    renderDialog({ repository });

    await userEvent.click(await screen.findByRole("button", { name: "Regenerate link" }));
    expect(screen.getByText(/previous link will stop working/i)).toBeVisible();
    expect(repository.regenerate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm regenerate" }));
    expect(await screen.findByDisplayValue(`https://tabloom.nickvu.dev/s/${replacementShare.token}`)).toBeVisible();
  });

  it("requires confirmation before disabling the public page", async () => {
    const repository = createRepository(firstShare);
    renderDialog({ repository });

    await userEvent.click(await screen.findByRole("button", { name: "Disable sharing" }));
    expect(screen.getByText(/public page will become unavailable/i)).toBeVisible();
    expect(repository.disable).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    expect(await screen.findByRole("button", { name: "Enable sharing" })).toBeVisible();
  });

  it("keeps the working URL and offers retry after a failed regeneration", async () => {
    const repository = createRepository(firstShare);
    vi.mocked(repository.regenerate)
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValueOnce(replacementShare);
    renderDialog({ repository });

    await userEvent.click(await screen.findByRole("button", { name: "Regenerate link" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm regenerate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Request timed out");
    expect(screen.getByDisplayValue(`https://tabloom.nickvu.dev/s/${firstShare.token}`)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue(`https://tabloom.nickvu.dev/s/${replacementShare.token}`)).toBeVisible();
  });

  it.each([
    ["sign-in-required", "Sign in to sync", "onRequestSignIn"],
    ["sync-required", "Retry sync", "onRequestSyncRetry"],
  ] as const)("routes %s through its host action without reading share state", async (availability, label, callback) => {
    const repository = createRepository(firstShare);
    const props = renderDialog({ availability, repository });
    await userEvent.click(screen.getByRole("button", { name: label }));

    expect(props[callback]).toHaveBeenCalledOnce();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it("does not guess share state while offline", () => {
    const repository = createRepository(firstShare);
    renderDialog({ availability: "offline", repository });

    expect(screen.getByText(/internet connection is required/i)).toBeVisible();
    expect(repository.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Enable sharing" })).not.toBeInTheDocument();
  });

  it("closes a confirmation with Escape before closing the dialog", async () => {
    const props = renderDialog({ repository: createRepository(firstShare) });
    await userEvent.click(await screen.findByRole("button", { name: "Disable sharing" }));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByText(/public page will become unavailable/i)).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });

  it("restores focus to the invoking share control when closed", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Share collection</button>{open && <CollectionShareDialog availability="offline" collection={collection} repository={null} siteUrl="https://tabloom.nickvu.dev" onRequestSignIn={vi.fn()} onRequestSyncRetry={vi.fn()} onToast={vi.fn()} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Share collection" });
    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Close sharing" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Close sharing" }));
    expect(trigger).toHaveFocus();
  });
});
