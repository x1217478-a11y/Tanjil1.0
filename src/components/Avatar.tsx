import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { sanitizeMediaUrl } from '../lib/security';

interface AvatarProps {
  src?: string;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  isOnline?: boolean;
  isVerified?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-7 h-7 text-xs',
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-24 h-24 text-2xl',
};

export function Avatar({
  src,
  name,
  size = 'md',
  isOnline,
  isVerified,
  className = '',
}: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const safeSrc = sanitizeMediaUrl(src);
  const initials = (name || 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  return (
    <div className={`relative inline-flex shrink-0 ${className}`}>
      <div
        className={`${SIZE_CLASSES[size]} rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold flex items-center justify-center ring-1 ring-black/5 dark:ring-white/10`}
      >
        {safeSrc && !broken ? (
          <img
            src={safeSrc}
            alt={name}
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span>{initials || 'U'}</span>
        )}
      </div>
      {isOnline && (
        <span
          aria-label="Online"
          className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900"
        />
      )}
      {isVerified && !isOnline && (
        <span
          aria-label="Verified"
          className="absolute -bottom-0.5 -right-0.5 bg-white dark:bg-slate-900 rounded-full p-0.5"
        >
          <BadgeCheck className="w-3.5 h-3.5 text-sky-500 fill-sky-500/15" />
        </span>
      )}
    </div>
  );
}

export function VerifiedBadge({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <BadgeCheck
      aria-label="Verified Account"
      className={`${className} text-sky-500 shrink-0 inline-block`}
    />
  );
}
