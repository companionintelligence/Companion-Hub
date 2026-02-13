import { Card, CardContent } from '@/components/ui/Card';
import clsx from 'clsx';
import './button-tile.css';

interface ButtonTileProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  className?: string;
  action: () => void;
}

export const ButtonTile = ({ title, subtitle, icon, action, className }: ButtonTileProps) => {
  return (
    <button onClick={action} className={clsx('button-tile', className)} type="button">
      <Card className="ml-0 text-primary hover:bg-accent/50 h-full border-dashed border-2 border-muted-foreground/20 hover:border-primary/40 transition-colors">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex items-center justify-center flex-shrink-0" style={{ width: '60px', height: '60px' }}>
            {icon}
          </div>
          <div>
            <div className="font-bold text-start">{title}</div>
            <div className="text-muted-foreground text-sm text-start">{subtitle}</div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
};
