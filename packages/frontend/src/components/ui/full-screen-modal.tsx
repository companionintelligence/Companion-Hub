import { IconX } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface FullScreenModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

export const FullScreenModal = ({ isOpen, onClose, children, title }: FullScreenModalProps) => {
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: '100%' }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'transparent',
            color: 'var(--tblr-body-color)',
            zIndex: 1050,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="page-body w-100">
            <div className="container-xl py-4">
              <div className="d-flex justify-content-between align-items-center mb-4">
                {title && <h1 className="m-0">{title}</h1>}
                <button
                  type="button"
                  className="btn btn-icon btn-ghost-secondary ms-auto"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <IconX size={32} />
                </button>
              </div>
              {children}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
