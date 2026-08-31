import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabloomMark } from "../shared/TabloomMark";

describe("TabloomMark", () => {
  it("renders the shared mark as decorative by default", () => {
    const { container } = render(<TabloomMark className="test-mark" />);

    const image = container.querySelector("img.test-mark");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image?.getAttribute("src")).toMatch(/(?:tabloom-mark\.svg|data:image\/svg\+xml)/);
  });

  it("exposes an accessible name when a title is supplied", () => {
    render(<TabloomMark title="Tabloom" />);

    expect(screen.getByRole("img", { name: "Tabloom" })).toBeInTheDocument();
  });
});
