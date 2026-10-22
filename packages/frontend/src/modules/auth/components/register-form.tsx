import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { meetsPasswordComplexity } from '@ci-hub/common/validation';
import { emailField } from '../helpers/email-field';
import { zodResolver } from '@hookform/resolvers/zod';
import type React from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';

interface IProps {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
  /** The CI Account sign-in, offered above the form for people who already have an account. */
  portalSignIn?: React.ReactNode;
  /** Where "Already have a CI Account? Sign in" goes. No link without it. */
  signInHref?: string;
}

type FormValues = { email: string; password: string; passwordConfirm: string };

export const RegisterForm: React.FC<IProps> = ({ onSubmit, loading, portalSignIn, signInHref }) => {
  const { t } = useTranslation();
  const schema = z
    .object({
      email: emailField(t),
      password: z.string().refine((value) => meetsPasswordComplexity(value), { message: t('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY') }),
      passwordConfirm: z.string().min(1, t('AUTH_FORM_PASSWORD_CONFIRMATION')),
    })
    .superRefine((data, ctx) => {
      if (data.password !== data.passwordConfirm) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('COMMON_PASSWORDS_DO_NOT_MATCH'),
          path: ['passwordConfirm'],
        });
      }
    });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
  });

  return (
    <>
      <div className="mb-4 text-center">
        <h2 className="text-xl font-semibold">{t('AUTH_REGISTER_TITLE')}</h2>
        {portalSignIn ? <div className="mt-4">{portalSignIn}</div> : null}
        <p className="mt-2 text-sm text-muted-foreground">{t('AUTH_REGISTER_NOTE')}</p>
        {/* Tells a CI Account holder to sign up here with the same email, which Portal refuses for an
            existing account. With the CI Account button above, that button is the way in. */}
        {portalSignIn ? null : <p className="mt-2 text-sm text-muted-foreground font-bold">{t('AUTH_REGISTER_NOTE_2')}</p>}
      </div>
      <form onSubmit={handleSubmit((values) => onSubmit(values))}>
        <Input
          {...register('email')}
          label={t('AUTH_FORM_EMAIL')}
          error={errors.email?.message}
          disabled={loading}
          type="email"
          className="mb-3"
          placeholder={t('AUTH_FORM_EMAIL_PLACEHOLDER')}
        />
        <PasswordInput
          {...register('password')}
          label={t('COMMON_PASSWORD')}
          helpText={t('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY')}
          error={errors.password?.message}
          disabled={loading}
          className="mb-3"
          placeholder={t('AUTH_FORM_PASSWORD_PLACEHOLDER')}
        />
        <PasswordInput
          {...register('passwordConfirm')}
          label={t('AUTH_FORM_PASSWORD_CONFIRMATION')}
          error={errors.passwordConfirm?.message}
          disabled={loading}
          className="mb-3"
          placeholder={t('AUTH_FORM_PASSWORD_CONFIRMATION_PLACEHOLDER')}
        />
        <div className="mt-4">
          <Button loading={loading} type="submit" intent="primary" className="w-full">
            {t('AUTH_REGISTER_SUBMIT')}
          </Button>
        </div>
        {signInHref ? (
          <div className="text-sm text-muted-foreground text-center mt-3">
            <Link to={signInHref}>{t('AUTH_REGISTER_SIGN_IN_INSTEAD')}</Link>
          </div>
        ) : null}
      </form>
    </>
  );
};
