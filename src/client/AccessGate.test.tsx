// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccessGate, type SessionApi } from "./AccessGate";

function sessionApi(): SessionApi {
  return {
    state: vi.fn().mockResolvedValue({ required: true, available: true, authenticated: false }),
    login: vi.fn().mockResolvedValue({ required: true, available: true, authenticated: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("browser access", () => {
  it("requires login, clears the password and supports logout", async () => {
    const api = sessionApi();
    const user = userEvent.setup();
    render(<AccessGate api={api}><p>Protected workbench</p></AccessGate>);
    expect(screen.queryByText("Protected workbench")).not.toBeInTheDocument();
    const input = await screen.findByLabelText("访问密码 / Access password");
    await user.type(input, "judge-password-long");
    await user.click(screen.getByRole("button", { name: "进入工作台 / Sign in" }));
    expect(await screen.findByText("Protected workbench")).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledWith("judge-password-long");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    await user.click(screen.getByRole("button", { name: "退出 / Sign out" }));
    expect(await screen.findByLabelText("访问密码 / Access password")).toHaveValue("");
    expect(screen.queryByText("Protected workbench")).not.toBeInTheDocument();
  });

  it("shows failed logins and clears the entered password", async () => {
    const api = sessionApi();
    vi.mocked(api.login).mockRejectedValue(new Error("Incorrect access password"));
    render(<AccessGate api={api}><p>Protected workbench</p></AccessGate>);
    const input = await screen.findByLabelText("访问密码 / Access password");
    fireEvent.change(input, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作台 / Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect access password");
    expect(input).toHaveValue("");
    expect(screen.queryByText("Protected workbench")).not.toBeInTheDocument();
  });

  it("allows demo access and handles expired sessions", async () => {
    const api = sessionApi();
    vi.mocked(api.state).mockResolvedValue({ required: false, available: false, authenticated: true });
    const view = render(<AccessGate api={api}><p>Demo workbench</p></AccessGate>);
    expect(await screen.findByText("Demo workbench")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出 / Sign out" })).not.toBeInTheDocument();
    view.unmount();
    vi.mocked(api.state).mockResolvedValue({ required: true, available: true, authenticated: true });
    render(<AccessGate api={api}><p>Protected workbench</p></AccessGate>);
    await screen.findByText("Protected workbench");
    act(() => window.dispatchEvent(new Event("leanbridge:session-expired")));
    await waitFor(() => expect(screen.queryByText("Protected workbench")).not.toBeInTheDocument());
    expect(await screen.findByLabelText("访问密码 / Access password")).toBeInTheDocument();
  });
});
