import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useTranslation } from 'react-i18next';
import { allTimezones, type ITimezoneOption, useTimezoneSelect } from 'react-timezone-select';
import './timezone-selector.css';

type IProps = {
  timeZone?: string;
  onChange: (timeZone: string) => void;
};

export const TimeZoneSelector = (props: IProps) => {
  const { onChange, timeZone } = props;
  const { options, parseTimezone } = useTimezoneSelect({ labelStyle: 'abbrev', timezones: allTimezones });
  const { t } = useTranslation();

  const onTimezoneChange = (e: string) => {
    if (!e) return;
    onChange(e);
  };

  const zone = timeZone || 'Etc/GMT';
  // The zone's own entry, or the one that names it or shares its offset (Europe/Berlin gets Amsterdam's).
  // The library returns `false` for an unknown name without a slash, such as 'UTC', which shows UTC. It
  // returns nothing when no entry shares the zone's offset (Pacific/Kiritimati), which shows the zone's
  // name, first in the list.
  const parsed = parseTimezone(zone) as ITimezoneOption | false | undefined;
  const selected: ITimezoneOption = parsed === undefined ? { value: zone, label: zone } : parsed || parseTimezone('Etc/GMT');
  // `options` keeps one zone for each offset and daylight saving rule, so it can lack the selected entry:
  // Asia/Karachi is folded into Asia/Yekaterinburg. A select shows an empty box for a value none of its
  // items has, so add the entry next to the zones with its offset.
  const items = options.some((option) => option.value === selected.value)
    ? options
    : [...options, selected].sort((a, b) => (a.offset ?? Number.NEGATIVE_INFINITY) - (b.offset ?? Number.NEGATIVE_INFINITY));

  return (
    <Select value={selected.value} onValueChange={onTimezoneChange}>
      <SelectTrigger className="mb-3" name="timezone" label={t('TIMEZONE_SELECTOR_LABEL')}>
        <SelectValue placeholder={t('TIMEZONE_SELECTOR_PLACEHOLDER')} />
      </SelectTrigger>
      <SelectContent className="select-content">
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
