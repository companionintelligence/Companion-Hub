import type React from 'react';

interface IProps {
  title: string;
  children: React.ReactNode;
}

export const DataGridItem: React.FC<IProps> = ({ children, title }) => (
  <div className="flex flex-col space-y-1.5">
    <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{title}</span>
    <div className="text-sm font-medium text-foreground">{children}</div>
  </div>
);
