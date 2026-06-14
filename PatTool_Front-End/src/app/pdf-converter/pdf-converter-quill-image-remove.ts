import Quill from 'quill';
import { removeSelectedImage } from './pdf-converter-quill-export';

interface ImageResizeLike {
  hide?: () => void;
}

/** Delete / Backspace removes the selected image embed. */
export default class ImageRemove {
  private readonly quill: Quill;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') {
      return;
    }
    if (!this.quill.hasFocus()) {
      return;
    }
    const removed = removeSelectedImage(this.quill);
    if (!removed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const resize = this.quill.getModule('imageResize') as ImageResizeLike | undefined;
    resize?.hide?.();
  };

  constructor(quill: Quill) {
    this.quill = quill;
    quill.root.addEventListener('keydown', this.onKeyDown, true);
  }

  destroy(): void {
    this.quill.root.removeEventListener('keydown', this.onKeyDown, true);
  }
}
