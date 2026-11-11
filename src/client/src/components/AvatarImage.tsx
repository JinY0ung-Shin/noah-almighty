import { useState, type CSSProperties } from "react";
import { avatarGradient, avatarImageUrl, initials } from "../lib/format";

export interface AvatarImageProps {
  user: { id: string; alias?: string; displayName?: string; username?: string; hasImage?: boolean } | null;
  size?: number;
  alt?: string;
}

export default function AvatarImage({ user, size = 40, alt = "" }: AvatarImageProps) {
  const [failedKey, setFailedKey] = useState("");
  const imageKey = `${user?.id || ""}:${user?.hasImage ? "1" : "0"}:${size}`;
  const url = failedKey !== imageKey ? avatarImageUrl(user, size) : null;
  const box = { width: `${size}px`, height: `${size}px`, "--avatar-size": `${size}px` } as CSSProperties;
  const style = url ? box : { ...box, background: avatarGradient(user), color: "var(--on-avatar)" };

  return (
    <span
      className="avatar-img"
      style={style}
      aria-hidden={alt === "" ? "true" : undefined}
      role={!url && alt ? "img" : undefined}
      aria-label={!url && alt ? alt : undefined}
    >
      {url ? (
        <img src={url} alt={alt} width={size} height={size} onError={() => setFailedKey(imageKey)} />
      ) : (
        <span aria-hidden="true">{initials(user)}</span>
      )}
    </span>
  );
}
