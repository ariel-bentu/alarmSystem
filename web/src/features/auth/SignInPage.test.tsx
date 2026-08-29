import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders as render, screen } from "@/test/renderWithProviders";
import SignInPage from "./SignInPage";

// Mock the AuthProvider
const mockSignIn = vi.fn();
vi.mock("@/app/AuthProvider", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    signIn: mockSignIn,
    signOut: vi.fn(),
  }),
}));

describe("SignInPage", () => {
  it("renders the sign-in button", () => {
    render(<SignInPage />);
    expect(
      screen.getByRole("button", { name: /sign in with google/i })
    ).toBeInTheDocument();
  });

  it("calls signIn when button is clicked", async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(mockSignIn).toHaveBeenCalledOnce();
  });

  it("renders a heading", () => {
    render(<SignInPage />);
    expect(screen.getByRole("heading", { name: /alarm/i })).toBeInTheDocument();
  });
});
