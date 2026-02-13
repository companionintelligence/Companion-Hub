import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { zodResolver } from '@hookform/resolvers/zod';
import type React from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import z from 'zod';

type FormValues = { email: string; password: string };

const schema = z.object({
  email: z.string().email(),
  password: z.string(),
});

interface IProps {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
  loginType: string;
}

export const LoginForm: React.FC<IProps> = ({ loading, onSubmit, loginType }) => {
  const { t } = useTranslation();
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm({
    resolver: zodResolver(schema),
  });

  const watchEmail = watch('email');
  const watchPassword = watch('password');

  const isDisabled = !watchEmail || !watchPassword;

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_LOGIN_TITLE', { type: loginType })}</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Input
          {...register('email')}
          name="email"
          label={t('AUTH_FORM_EMAIL')}
          error={errors.email?.message}
          disabled={loading}
          type="email"
          className="mb-3"
          placeholder={t('AUTH_FORM_EMAIL_PLACEHOLDER')}
        />
        <Input
          {...register('password')}
          name="password"
          label={t('AUTH_FORM_PASSWORD')}
          error={errors.password?.message}
          disabled={loading}
          type="password"
          className="mb-3 password-input"
          placeholder={t('AUTH_FORM_PASSWORD_PLACEHOLDER')}
        />
        <div className="mt-4">
          <Button disabled={isDisabled} loading={loading} type="submit" intent="primary" className="w-full">
            {t('AUTH_LOGIN_SUBMIT')}
          </Button>
        </div>
        <div className="text-sm text-muted-foreground text-center mt-3">
          <Link to="/reset-password">{t('AUTH_FORM_FORGOT')}</Link>
        </div>
      </form>
    </>
  );
};
