import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import type React from 'react';
import './empty-page.css';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

interface IProps {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  redirectPath?: string;
  extraContent?: React.ReactNode;
}

export const EmptyPage: React.FC<IProps> = ({ title, subtitle, redirectPath, actionLabel, extraContent }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Card className="empty">
      <CardContent className="flex flex-col items-center justify-center p-8 text-center">
        <img
          src="/empty.svg"
          alt="Empty box"
          height="80"
          width="80"
          className="empty-image mb-3"
          style={{
            maxWidth: '100%',
            height: '80px',
          }}
        />
        <p className="empty-title text-xl font-medium">{t(title)}</p>
        {subtitle && <p className="empty-subtitle text-muted-foreground">{t(subtitle)}</p>}
        {extraContent && <div className="mt-3">{extraContent}</div>}
        <div className="empty-action mt-4">
          {redirectPath && actionLabel && (
            <Button data-testid="empty-page-action" onClick={() => navigate(redirectPath)} intent="primary">
              {t(actionLabel)}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
