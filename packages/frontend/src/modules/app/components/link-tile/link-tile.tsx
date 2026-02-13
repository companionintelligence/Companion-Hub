import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/ContextMenu/ContextMenu';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { CustomLink } from '@/types/app.types';
import { Edit, Trash } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { AddLinkDialog } from '../dialogs/add-link/add-link-dialog';
import { DeleteLinkDialog } from '../dialogs/delete-link/delete-link-dialog';

type LinkTileProps = {
  link: CustomLink;
};

export const LinkTile: React.FC<LinkTileProps> = ({ link }) => {
  const { t } = useTranslation();

  const addLinkDisclosure = useDisclosure();
  const deleteLinkDisclosure = useDisclosure();

  const handleEdit = () => {
    addLinkDisclosure.open();
  };

  const handleDelete = () => {
    deleteLinkDisclosure.open();
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <a href={link.url} target="_blank" rel="noreferrer" className="block text-decoration-none">
            <Card className="hover:opacity-80 transition-opacity">
              <CardContent className="flex items-center gap-3 p-4">
                <AppLogo url={link.iconUrl || ''} size={60} />
                <div>
                  <span className="font-bold">{link.title}</span>
                  {link.description?.length !== 0 && <div className="text-muted-foreground break-all">{link.description}</div>}
                </div>
              </CardContent>
            </Card>
          </a>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleEdit}>
            <Edit size={15} className="me-1" />
            {t('LINKS_EDIT_CONTEXT_MENU')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleDelete}>
            <Trash size={15} className="me-1" />
            {t('LINKS_DELETE_CONTEXT_MENU')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AddLinkDialog isOpen={addLinkDisclosure.isOpen} onClose={addLinkDisclosure.close} link={link} />
      <DeleteLinkDialog isOpen={deleteLinkDisclosure.isOpen} onClose={deleteLinkDisclosure.close} linkTitle={link.title} linkId={link.id} />
    </>
  );
};
