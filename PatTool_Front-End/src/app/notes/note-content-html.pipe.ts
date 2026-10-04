import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { linkifyNoteContent } from './note-content-html';

/** Renders note text with clickable http(s) links. Markup is escaped in {@link linkifyNoteContent}. */
@Pipe({
    name: 'noteContentHtml',
    standalone: true
})
export class NoteContentHtmlPipe implements PipeTransform {
    private readonly sanitizer = inject(DomSanitizer);

    transform(value: string | null | undefined): SafeHtml {
        return this.sanitizer.bypassSecurityTrustHtml(linkifyNoteContent(value));
    }
}
