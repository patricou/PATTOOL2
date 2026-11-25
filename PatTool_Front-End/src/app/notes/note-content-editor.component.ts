import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges,
    ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { noteContentIsBlank, sanitizeNoteContent } from './note-content-html';

type FormatCommand = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList';

@Component({
    selector: 'app-note-content-editor',
    standalone: true,
    imports: [CommonModule, TranslateModule],
    templateUrl: './note-content-editor.component.html',
    styleUrls: ['./note-content-editor.component.css']
})
export class NoteContentEditorComponent implements AfterViewInit, OnChanges {
    @Input() value: string | null | undefined = '';
    @Input() readonly = false;
    @Input() placeholder = '';
    @Input() maxlength = 8000;
    @Output() valueChange = new EventEmitter<string>();

    @ViewChild('box') box?: ElementRef<HTMLDivElement>;

    empty = true;
    private lastEmitted = '';
    private lastGood = '';

    ngAfterViewInit(): void {
        this.writeToBox(this.value || '');
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!changes['value'] || !this.box) {
            return;
        }
        const next = changes['value'].currentValue || '';
        if (next === this.lastEmitted) {
            return;
        }
        this.writeToBox(next);
    }

    format(command: FormatCommand): void {
        if (this.readonly) {
            return;
        }
        this.box?.nativeElement.focus();
        document.execCommand(command, false);
        this.publish();
    }

    onInput(): void {
        this.publish();
    }

    onPaste(event: ClipboardEvent): void {
        if (this.readonly) {
            return;
        }
        event.preventDefault();
        const html = event.clipboardData?.getData('text/html') || '';
        const text = event.clipboardData?.getData('text/plain') || '';
        if (html.trim()) {
            document.execCommand('insertHTML', false, sanitizeNoteContent(html));
        } else if (text) {
            document.execCommand('insertText', false, text);
        }
        this.publish();
    }

    private publish(): void {
        const el = this.box?.nativeElement;
        if (!el) {
            return;
        }
        const clean = sanitizeNoteContent(el.innerHTML);
        if (clean.length > this.maxlength) {
            this.writeToBox(this.lastGood);
            return;
        }
        this.lastGood = clean;
        this.lastEmitted = clean;
        this.empty = noteContentIsBlank(clean);
        if ((this.value || '') !== clean) {
            this.valueChange.emit(clean);
        }
    }

    private writeToBox(value: string): void {
        const el = this.box?.nativeElement;
        if (!el) {
            return;
        }
        const clean = sanitizeNoteContent(value);
        this.lastGood = clean;
        this.lastEmitted = clean;
        this.empty = noteContentIsBlank(clean);
        if (el.innerHTML !== clean) {
            el.innerHTML = clean;
        }
    }
}
