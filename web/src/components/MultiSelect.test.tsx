// Dropdown multi-select: a button showing the current selection, opening a
// panel of checkboxes.
//
// Deliberately NOT a native <select multiple>: that one needs Cmd/Ctrl-click
// to pick a second option, and a plain click on another option silently clears
// the rest — a trap for the camera picker, where adding a second camera to a
// sensor is the normal case.
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { MultiSelect } from "./MultiSelect";

const OPTIONS = [
  { value: 1, label: "Front door" },
  { value: 2, label: "Driveway" },
  { value: 3, label: "Back yard" },
];

describe("MultiSelect", () => {
  it("shows the summary of the current selection on the trigger", () => {
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[1, 3]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    expect(
      screen.getByRole("button", { name: /front door, back yard/i })
    ).toBeInTheDocument();
  });

  it("shows the empty label when nothing is selected", () => {
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    expect(screen.getByRole("button", { name: /no cameras/i })).toBeInTheDocument();
  });

  it("keeps the panel closed until the trigger is clicked", () => {
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    expect(screen.queryByRole("checkbox", { name: "Driveway" })).toBeNull();
  });

  it("opens the panel of checkboxes on click", async () => {
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[1]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /front door/i }));

    expect(screen.getByRole("checkbox", { name: "Front door" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Driveway" })).not.toBeChecked();
  });

  it("ADDS to the selection on a plain click, never replaces it", async () => {
    // The whole reason this component exists instead of <select multiple>.
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[1]}
        onChange={onChange}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /front door/i }));
    await user.click(screen.getByRole("checkbox", { name: "Back yard" }));

    expect(onChange).toHaveBeenCalledWith([1, 3]);
  });

  it("removes a value when its checked box is clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[1, 3]}
        onChange={onChange}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /front door/i }));
    await user.click(screen.getByRole("checkbox", { name: "Front door" }));

    expect(onChange).toHaveBeenCalledWith([3]);
  });

  it("can empty the selection entirely", async () => {
    // Empty is a real state for the camera picker ("capture nothing"), so it
    // must be reachable by unticking the last box.
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[2]}
        onChange={onChange}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /driveway/i }));
    await user.click(screen.getByRole("checkbox", { name: "Driveway" }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("returns values in ascending order regardless of click order", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[3]}
        onChange={onChange}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /back yard/i }));
    await user.click(screen.getByRole("checkbox", { name: "Front door" }));

    expect(onChange).toHaveBeenCalledWith([1, 3]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /no cameras/i }));
    expect(screen.getByRole("checkbox", { name: "Driveway" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("checkbox", { name: "Driveway" })).toBeNull();
  });

  it("closes on an outside click", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <MultiSelect
          options={OPTIONS}
          selected={[]}
          onChange={vi.fn()}
          label="Cameras"
          emptyLabel="No cameras"
        />
        <button type="button">elsewhere</button>
      </div>
    );
    await user.click(screen.getByRole("button", { name: /no cameras/i }));
    expect(screen.getByRole("checkbox", { name: "Driveway" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("checkbox", { name: "Driveway" })).toBeNull();
  });

  it("stays open across several toggles, so multiple picks need one open", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={onChange}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /no cameras/i }));
    await user.click(screen.getByRole("checkbox", { name: "Front door" }));
    expect(screen.getByRole("checkbox", { name: "Driveway" })).toBeInTheDocument();
  });

  it("renders the panel outside any clipping ancestor", async () => {
    // This control sits inside .table-wrap, whose `overflow-x: auto` makes a
    // scroll container — and that clips absolutely positioned descendants on
    // BOTH axes, so an in-flow panel was cut off at the table's edge. The panel
    // must therefore NOT be a descendant of the scroller.
    const user = userEvent.setup();
    render(
      <div data-testid="scroller" style={{ overflowX: "auto" }}>
        <MultiSelect
          options={OPTIONS}
          selected={[]}
          onChange={vi.fn()}
          label="Cameras"
          emptyLabel="No cameras"
        />
      </div>
    );
    await user.click(screen.getByRole("button", { name: /no cameras/i }));

    const box = screen.getByRole("checkbox", { name: "Driveway" });
    expect(screen.getByTestId("scroller")).not.toContainElement(box);
  });

  it("stays open when a checkbox inside the portalled panel is clicked", async () => {
    // Regression guard for the portal: the panel is no longer a DOM descendant
    // of the component root, so an outside-click test against the root alone
    // would close the panel on the very first tick.
    const user = userEvent.setup();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    await user.click(screen.getByRole("button", { name: /no cameras/i }));
    await user.click(screen.getByRole("checkbox", { name: "Front door" }));

    expect(screen.getByRole("checkbox", { name: "Driveway" })).toBeInTheDocument();
  });

  it("names the trigger with BOTH the field label and the selection", () => {
    // A bare aria-label="Cameras" would hide what is selected from a screen
    // reader, which is the one thing the trigger exists to communicate.
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[1, 3]}
        onChange={vi.fn()}
        label="Cameras"
        emptyLabel="No cameras"
      />
    );
    expect(
      screen.getByRole("button", { name: "Cameras Front door, Back yard" })
    ).toBeInTheDocument();
  });
});
