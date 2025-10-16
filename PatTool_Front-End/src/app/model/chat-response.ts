export class ChatResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
        logprobs: any;
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    system_fingerprint: string;

    constructor(data: any) {
        this.id = data.id;
        this.object = data.object;
        this.created = data.created;
        this.model = data.model;
        this.choices = data.choices.map((choice: any) => ({
            index: choice.index,
            message: {
                role: choice.message.role,
                content: this.decodeHtml(choice.message.content)
            },
            logprobs: choice.logprobs,
            finish_reason: choice.finish_reason
        }));
        this.usage = data.usage;
        this.system_fingerprint = data.system_fingerprint;
    }

    private decodeHtml(html: string): string {
        const txt = document.createElement('textarea');
        txt.innerHTML = html;
        return txt.value;
    }
}
