import { Button } from '@/components/ui/Button';
import type React from 'react';
import { useTranslation } from 'react-i18next';

interface IProps {
  isEdit?: boolean;
  loading?: boolean;
  formId: string;
  disabled?: boolean;
}

export const InstallFormButtons: React.FC<IProps> = ({ isEdit, loading, formId, disabled }) => {
  const { t } = useTranslation();

  return (
    <Button loading={loading} disabled={disabled} type="submit" intent="success" form={formId}>
      {isEdit ? t('APP_INSTALL_FORM_SUBMIT_UPDATE') : t('APP_INSTALL_FORM_SUBMIT_INSTALL')}
    </Button>
  );
};
