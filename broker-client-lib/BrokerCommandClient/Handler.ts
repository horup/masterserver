
/** A function which processes a command C, on a state S.
 *  Push can be called to send new commands.
 *  If transmit is true, the commands are also transmitted.
 */
export type Handler<S,C> = (s:S, c:C, push?:(c:C, transmit:boolean)=>void) => void;

export function process<S,C>(handlers:Handler<S,C>[], s:S, c:C, push:(c:C, transmit:boolean)=>any)
{
    let produced:{c:C, transmit:boolean}[] = [];
    handlers.forEach(handler =>
    {
        let res = handler(s, c, (c, transmit)=>
        {
            produced.push({c:c, transmit:transmit});
        });
    });

    while (produced.length > 0)
    {
        let c = produced.pop();
        push(c.c, c.transmit);
    }
}