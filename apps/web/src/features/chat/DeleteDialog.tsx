import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { Preview } from './ForwardDialog';
import { keyboardIsOnRow, rowInstead } from './message-actions';
import { closeDelete, deleteMessage, useChat } from './store';
import styles from './chat.module.scss';

export function DeleteDialog() {
  const [message] = useState(() => useChat.getState().deleting);
  const [fromRow] = useState(() => !!message && keyboardIsOnRow(message.id));
  const [busy, setBusy] = useState(false);
  if (!message) return null;

  const remove = async () => {
    setBusy(true);
    const instead = fromRow ? rowInstead(message.id) : null;
    const deleted = await deleteMessage(message.id);
    if (useChat.getState().deleting !== message) return;
    closeDelete();
    if (deleted) instead?.focus({ preventScroll: true });
  };

  return (
    <Modal title="Delete this message?" onClose={closeDelete} width={420}>
      <Preview message={message} />
      <p className={styles.deleteNote}>This cannot be undone.</p>
      <div className={styles.deleteActions}>
        <Button onClick={closeDelete} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void remove()} busy={busy}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}
