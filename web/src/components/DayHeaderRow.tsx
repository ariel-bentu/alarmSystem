// A day heading inside a table body, used by every list that groups rows by
// when something was last seen (paired sensors, unrecognised sensors, event
// history). Shared so the three cannot drift apart in wording or markup.
import { dayHeading } from "@/features/configure/lastSeenFormat";
import { useT } from "@/i18n/I18nProvider";

export function DayHeaderRow({
  date,
  isToday,
  isNever,
  colSpan,
}: {
  /** Any timestamp from the day. Null only for the never-seen group. */
  date: number | null;
  isToday: boolean;
  isNever?: boolean;
  colSpan: number;
}) {
  const t = useT();
  return (
    <tr className="day-row">
      <th scope="colgroup" colSpan={colSpan}>
        {isNever || date === null
          ? t("common.never")
          : isToday
            ? t("time.today")
            : dayHeading(date)}
      </th>
    </tr>
  );
}
