import { AppLogo } from '@/components/app-logo/app-logo';
import { Upload } from 'lucide-react';
import clsx from 'clsx';
import type React from 'react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './custom-app-logo.css';
import { toast } from 'sonner';

export const CustomAppLogo: React.FC<{
  urn?: string;
  url?: string;
  /** Pixels, or a CSS length such as `100%` to fill a box the caller sizes. */
  size?: number | string;
  className?: string;
  alt?: string;
  /** The name the placeholder takes its letter from while the app has no image. */
  name?: string;
  shape?: 'squircle' | 'rounded';
  onImageUpload?: (file: File) => void;
  isUploading?: boolean;
}> = ({ urn, url, size = 80, className = '', alt = '', name, shape, onImageUpload, isUploading = false }) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (onImageUpload && !isUploading) {
      fileInputRef.current?.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) return;

    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      toast.error(t('FILE_TOO_LARGE'));
      e.target.value = '';
      return;
    }

    if (!file.type.startsWith('image/')) {
      toast.error(t('INVALID_FILE_TYPE'));
      e.target.value = '';
      return;
    }

    if (file.type !== 'image/jpeg' && file.type !== 'image/jpg') {
      toast.error(t('INVALID_FILE_TYPE'));
      e.target.value = '';
      return;
    }

    if (file && onImageUpload) {
      onImageUpload(file);
      e.target.value = '';
    }
  };

  return (
    <div className={clsx('custom-app-logo-container', { 'is-rounded': shape === 'rounded' }, className)} style={{ width: size, height: size }}>
      <AppLogo urn={urn} url={url} size={size} alt={alt} name={name} shape={shape} />
      {onImageUpload && (
        <>
          <button
            type="button"
            onClick={handleClick}
            className={clsx('custom-app-logo-overlay', { 'is-uploading': isUploading })}
            aria-label={t('CUSTOM_APP_UPLOAD_IMAGE')}
            disabled={isUploading}
          >
            <div className="custom-app-logo-overlay-content">
              <Upload size={typeof size === 'number' ? size / 3 : 32} className="custom-app-logo-icon" />
              <span className="custom-app-logo-text">{isUploading ? t('CUSTOM_APP_UPLOADING') : t('CUSTOM_APP_UPLOAD_IMAGE')}</span>
            </div>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,image/jpeg"
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-label={t('CUSTOM_APP_UPLOAD_IMAGE')}
          />
        </>
      )}
    </div>
  );
};
