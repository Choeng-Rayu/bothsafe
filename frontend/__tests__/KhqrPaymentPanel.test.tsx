import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { KhqrPaymentPanel } from "@/components/deal/KhqrPaymentPanel";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock fetch for polling
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ status: "ready_for_payment" }),
  }));
});

describe("KhqrPaymentPanel", () => {
  it("renders QR image and reference note", () => {
    render(
      <KhqrPaymentPanel
        publicId="abc123"
        imageUrl="https://example.com/qr.png"
        referenceNote="REF-001"
        amount="25.00"
        currency="USD"
      />
    );
    const img = screen.getByAltText("KHQR");
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toBe("https://example.com/qr.png");
    expect(screen.getByText("REF-001")).toBeDefined();
    expect(screen.getByText("payment.amount_due_label: 25.00 USD")).toBeDefined();
  });

  it("renders bakong deeplink button", () => {
    render(
      <KhqrPaymentPanel
        publicId="abc123"
        imageUrl="https://example.com/qr.png"
        referenceNote="REF-001"
        amount="25.00"
        currency="USD"
      />
    );
    const link = screen.getByText("payment.open_bakong");
    expect(link.getAttribute("href")).toContain("bakong://pay");
  });
});
