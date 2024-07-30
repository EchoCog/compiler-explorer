import {SQS} from '@aws-sdk/client-sqs';

import {ExecutionParams} from '../../types/compilation/compilation.interfaces.js';
import {logger} from '../logger.js';
import {PropertyGetter} from '../properties.interfaces.js';
import {getHash} from '../utils.js';

import {LocalExecutionEnvironment} from './_all.js';
import {EventsWsSender} from './events-websocket.js';
import {ExecutionTriple} from './execution-triple.js';

export type RemoteExecutionMessage = {
    guid: string;
    hash: string;
    params: ExecutionParams;
};

export class SqsExecuteQueueBase {
    protected sqs: SQS;
    protected queue_url: string;

    constructor(props: PropertyGetter, awsProps: PropertyGetter) {
        const region = awsProps<string>('region', '');
        this.sqs = new SQS({region: region});
        this.queue_url = props<string>('execqueue.queue_url', '');
        if (this.queue_url === '') throw new Error('execqueue.queue_url property required');
    }

    getSqsQueueUrl(triple: ExecutionTriple) {
        return this.queue_url + '-' + triple.toString() + '.fifo';
    }
}

export class SqsExecuteRequester extends SqsExecuteQueueBase {
    async push(triple: ExecutionTriple, message: RemoteExecutionMessage): Promise<any> {
        const body = JSON.stringify(message);
        return this.sqs.sendMessage({
            QueueUrl: this.getSqsQueueUrl(triple),
            MessageBody: body,
            MessageGroupId: 'default',
            MessageDeduplicationId: getHash(body),
        });
    }
}

export class SqsWorkerMode extends SqsExecuteQueueBase {
    protected triple: ExecutionTriple;

    constructor(props: PropertyGetter, awsProps: PropertyGetter) {
        super(props, awsProps);
        this.triple = new ExecutionTriple();
        // this.triple.setInstructionSet('aarch64'); // test
        // todo: determine and set specialty somehow
    }

    async pop(): Promise<RemoteExecutionMessage | undefined> {
        const url = this.getSqsQueueUrl(this.triple);

        const queued_messages = await this.sqs.receiveMessage({
            QueueUrl: url,
            MaxNumberOfMessages: 1,
        });

        if (queued_messages.Messages && queued_messages.Messages.length === 1) {
            const queued_message = queued_messages.Messages[0];

            try {
                if (queued_message.Body) {
                    const json = queued_message.Body;
                    logger.info('going to return (body)');
                    return JSON.parse(json) as RemoteExecutionMessage;
                } else {
                    logger.info('going to return (undefined)');
                    return undefined;
                }
            } finally {
                logger.info('in finally');
                if (queued_message.ReceiptHandle) {
                    logger.info('has a receipthandle');
                    await this.sqs.deleteMessage({
                        QueueUrl: url,
                        ReceiptHandle: queued_message.ReceiptHandle,
                    });
                    logger.info('deleted message');
                }
                logger.info('done with finally');
            }
        }

        return undefined;
    }
}

export function startExecutionWorkerThread(ceProps, awsProps, compilationEnvironment) {
    const queue = new SqsWorkerMode(ceProps, awsProps);

    const doExecutionWork = async () => {
        const msg = await queue.pop();
        if (msg && msg.guid) {
            const executor = new LocalExecutionEnvironment(compilationEnvironment);
            await executor.downloadExecutablePackage(msg.hash);
            const result = await executor.execute(msg.params);

            const sender = new EventsWsSender(compilationEnvironment.ceProps);
            await sender.send(msg.guid, result);
            await sender.close();
        }
        setTimeout(doExecutionWork, 500);
    };

    setTimeout(doExecutionWork, 1500);
}
