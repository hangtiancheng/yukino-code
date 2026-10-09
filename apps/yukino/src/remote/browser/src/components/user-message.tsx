interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="mb-5 flex justify-end">
      <div className="max-w-[92%] rounded-2xl rounded-br-md bg-user-bg px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-user-text shadow-xs sm:max-w-[85%]">
        {content}
      </div>
    </div>
  );
}
