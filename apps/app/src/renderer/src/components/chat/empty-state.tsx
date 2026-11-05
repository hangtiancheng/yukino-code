import {
  ArrowUpRightIcon,
  Code2Icon,
  GitPullRequestIcon,
  ScanSearchIcon,
  SnowflakeIcon,
} from "lucide-react";

export function EmptyState({
  onPrompt,
}: {
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <SnowflakeIcon strokeWidth={1.4} />
      </div>
      <div className="suggestion-grid">
        {[
          {
            icon: ScanSearchIcon,
            title: "了解项目",
            prompt:
              "请分析当前项目的结构、核心模块和启动方式，先阅读代码再给出说明。",
          },
          {
            icon: Code2Icon,
            title: "实现功能",
            prompt:
              "我想在当前项目中实现一个新功能。请先了解项目，并询问我的具体需求。",
          },
          {
            icon: GitPullRequestIcon,
            title: "审查变更",
            prompt:
              "/review 检查当前项目的未提交变更，重点关注错误、边界条件和可靠性",
          },
        ].map((item) => (
          <button
            key={item.title}
            onClick={() => {
              onPrompt(item.prompt);
            }}
          >
            <item.icon />
            <strong>{item.title}</strong>
            <ArrowUpRightIcon className="suggestion-arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}
