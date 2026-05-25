import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MissingFieldsChecklist } from "@/components/deal/MissingFieldsChecklist";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("MissingFieldsChecklist", () => {
  it("renders all missing fields", () => {
    render(<MissingFieldsChecklist fields={["product_title", "deal_amount"]} />);
    expect(screen.getByText("product_title")).toBeDefined();
    expect(screen.getByText("deal_amount")).toBeDefined();
  });

  it("renders nothing when fields array is empty", () => {
    const { container } = render(<MissingFieldsChecklist fields={[]} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
