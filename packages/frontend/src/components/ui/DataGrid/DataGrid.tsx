import { Card, CardContent } from '../Card/Card';
import type React from 'react';

interface IProps {
  children: React.ReactNode;
}

export const DataGrid: React.FC<IProps> = ({ children }) => (
  <Card>
    <CardContent className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">{children}</CardContent>
  </Card>
);
