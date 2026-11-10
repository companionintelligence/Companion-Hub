import { createLinkMutation, deleteLinkMutation, editLinkMutation, getLinksQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import type { CustomLink } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';

/** The limits `POST /api/links` holds a link to, so the form names them before the Hub refuses. */
export const GUEST_LINK_TITLE_MAX = 20;
export const GUEST_LINK_DESCRIPTION_MAX = 50;

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const linkFormSchema = z.object({
  title: z.string().trim().min(1, 'GUEST_LINK_TITLE_REQUIRED').max(GUEST_LINK_TITLE_MAX, 'GUEST_LINK_TITLE_TOO_LONG'),
  url: z.string().trim().refine(isHttpUrl, 'GUEST_LINK_URL_INVALID'),
  description: z.string().trim().max(GUEST_LINK_DESCRIPTION_MAX, 'GUEST_LINK_DESCRIPTION_TOO_LONG'),
  iconUrl: z
    .string()
    .trim()
    .refine((value) => value === '' || isHttpUrl(value), 'GUEST_LINK_ICON_INVALID'),
  isVisibleOnGuestDashboard: z.boolean(),
});

type LinkFormValues = z.infer<typeof linkFormSchema>;

interface GuestLinkDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The link to change; without one the dialog adds a new link. */
  link?: CustomLink | null;
}

/** Adds or changes one guest dashboard link (#2422), through the `/api/links` routes that had no screen. */
export const GuestLinkDialog = ({ isOpen, onClose, link }: GuestLinkDialogProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();

  const { register, control, handleSubmit, formState, reset } = useForm<LinkFormValues>({
    resolver: zodResolver(linkFormSchema),
    values: {
      title: link?.title ?? '',
      url: link?.url ?? '',
      description: link?.description ?? '',
      iconUrl: link?.iconUrl ?? '',
      isVisibleOnGuestDashboard: link ? link.isVisibleOnGuestDashboard : true,
    },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSaved = (key: 'GUEST_LINK_ADDED' | 'GUEST_LINK_SAVED', title: string) => {
    void queryClient.invalidateQueries({ queryKey: getLinksQueryKey() });
    toast.success(t(key, { title }));
    close();
  };
  const onError = (error: TranslatableError) => {
    toast.error(t(error.message, error.intlParams));
  };

  const createLink = useMutation({ ...createLinkMutation(), onError });
  const editLink = useMutation({ ...editLinkMutation(), onError });
  const saving = createLink.isPending || editLink.isPending;

  // The form's fields are the request body's, already trimmed by the schema.
  const save = (values: LinkFormValues) => {
    if (link) {
      editLink.mutate({ path: { id: link.id }, body: values }, { onSuccess: () => onSaved('GUEST_LINK_SAVED', values.title) });
    } else {
      createLink.mutate({ body: values }, { onSuccess: () => onSaved('GUEST_LINK_ADDED', values.title) });
    }
  };

  const fieldError = (message?: string) =>
    message ? t(message, { max: message.endsWith('TITLE_TOO_LONG') ? GUEST_LINK_TITLE_MAX : GUEST_LINK_DESCRIPTION_MAX }) : undefined;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{link ? t('GUEST_LINK_DIALOG_EDIT_TITLE', { title: link.title }) : t('GUEST_LINK_DIALOG_ADD_TITLE')}</DialogTitle>
          <DialogDescription>{t('GUEST_LINK_DIALOG_DESCRIPTION')}</DialogDescription>
        </DialogHeader>
        <form id={formId} onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-4">
          <Input
            label={t('GUEST_LINK_FIELD_TITLE')}
            placeholder={t('GUEST_LINK_FIELD_TITLE_PLACEHOLDER')}
            maxLength={GUEST_LINK_TITLE_MAX}
            error={fieldError(formState.errors.title?.message)}
            disabled={saving}
            {...register('title')}
          />
          <Input
            label={t('GUEST_LINK_FIELD_URL')}
            placeholder="https://"
            type="url"
            error={fieldError(formState.errors.url?.message)}
            disabled={saving}
            {...register('url')}
          />
          <Input
            label={t('GUEST_LINK_FIELD_DESCRIPTION')}
            placeholder={t('GUEST_LINK_FIELD_DESCRIPTION_PLACEHOLDER')}
            maxLength={GUEST_LINK_DESCRIPTION_MAX}
            error={fieldError(formState.errors.description?.message)}
            disabled={saving}
            {...register('description')}
          />
          <div>
            <Input
              label={t('GUEST_LINK_FIELD_ICON')}
              placeholder="https://"
              type="url"
              error={fieldError(formState.errors.iconUrl?.message)}
              disabled={saving}
              {...register('iconUrl')}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('GUEST_LINK_FIELD_ICON_HELP')}</p>
          </div>
          <Controller
            control={control}
            name="isVisibleOnGuestDashboard"
            render={({ field: { onChange, value, ref, ...rest } }) => (
              <Switch ref={ref} checked={value} onCheckedChange={onChange} disabled={saving} {...rest} label={t('GUEST_LINK_FIELD_VISIBLE')} />
            )}
          />
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            {t('COMMON_CANCEL')}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {link ? t('COMMON_SAVE') : t('GUEST_LINK_ADD')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface DeleteGuestLinkDialogProps {
  isOpen: boolean;
  onClose: () => void;
  link: CustomLink | null;
}

/** Confirms deleting a link, as Settings confirms deleting an app store. */
export const DeleteGuestLinkDialog = ({ isOpen, onClose, link }: DeleteGuestLinkDialogProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const deleteLink = useMutation({
    ...deleteLinkMutation(),
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getLinksQueryKey() });
      toast.success(t('GUEST_LINK_DELETED', { title: link?.title ?? '' }));
      onClose();
    },
  });

  return (
    <Dialog open={isOpen && link !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent type="danger" size="sm">
        <DialogHeader>
          <DialogTitle>{t('GUEST_LINK_DELETE_TITLE', { title: link?.title ?? '' })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-center py-4">
          <AlertTriangle className="mb-2 text-destructive size-12 mx-auto" />
          <span className="text-muted-foreground">{t('GUEST_LINK_DELETE_BODY')}</span>
        </DialogDescription>
        <DialogFooter>
          <Button loading={deleteLink.isPending} intent="danger" onClick={() => link && deleteLink.mutate({ path: { id: link.id } })}>
            {t('COMMON_DELETE')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
