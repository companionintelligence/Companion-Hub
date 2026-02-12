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
    <button onClick={action} className={clsx('col-sm-6 col-lg-4 button-tile p-2 pt-0 pb-0 mb-0', className)} type="button">
      <Card className="ml-0 text-primary hover:bg-accent/50 card-sm">
        <CardContent className="flex items-center gap-3">
          <div className="flex items-center justify-center" style={{ width: '60px', height: '60px' }}>
            {icon}
          </div>
          <div>
            <div className="fw-bolder text-start">{title}</div>
            <div className="text-muted text-start">{subtitle}</div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
};
