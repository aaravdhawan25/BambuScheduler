import { useQuery } from '@tanstack/react-query';
import { Box } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Thumb({ path, alt, className }: { path: string | null; alt: string; className?: string }) {
  const { data: url } = useQuery({
    queryKey: ['thumb', path],
    queryFn: () => (path ? api.thumbnailUrl(path) : null),
    enabled: !!path,
    staleTime: 45 * 60_000,
  });
  return (
    <div className={cn('grid shrink-0 place-items-center overflow-hidden rounded-xl bg-muted', className)}>
      {url ? (
        <img src={url} alt={alt} className="size-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <Box aria-hidden className="size-1/3 text-muted-foreground/60" />
      )}
    </div>
  );
}
