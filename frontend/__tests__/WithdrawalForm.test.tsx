import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Import the page component (it's the WithdrawalForm effectively)
import WithdrawPage from "@/app/wallet/withdraw/page";

describe("WithdrawalForm (WithdrawPage)", () => {
  it("renders KHQR and bank toggle buttons", () => {
    render(<WithdrawPage />);
    expect(screen.getByText("withdrawal.destination.khqr")).toBeDefined();
    expect(screen.getByText("withdrawal.destination.bank")).toBeDefined();
  });

  it("shows bank fields when bank is selected", () => {
    render(<WithdrawPage />);
    const bankBtn = screen.getByText("withdrawal.destination.bank");
    fireEvent.click(bankBtn);
    expect(screen.getByText("withdrawal.bank_name_label")).toBeDefined();
    expect(screen.getByText("withdrawal.bank_account_name_label")).toBeDefined();
    expect(screen.getByText("withdrawal.bank_account_number_label")).toBeDefined();
  });

  it("hides bank fields when KHQR is selected", () => {
    render(<WithdrawPage />);
    // Default is KHQR
    expect(screen.queryByText("withdrawal.bank_name_label")).toBeNull();
  });
});
