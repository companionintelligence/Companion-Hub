import { X } from 'lucide-react';
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
            zIndex: 1050,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
          className="text-foreground"
        >
          <div className="w-full">
            <div className="container mx-auto max-w-screen-xl px-4 py-4">
              <div className="flex justify-between items-center mb-4">
                {title && <h1 className="m-0">{title}</h1>}
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors ml-auto"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X size={32} />
                </button>
              </div>
              {children}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
