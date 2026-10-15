import type { ComponentPropsWithRef } from "react"
import "./ui.css"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant
  size?: "sm" | "md"
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const classes = ["ui-button", className].filter(Boolean).join(" ")
  return (
    <button type={type} className={classes} data-variant={variant} data-size={size} {...rest} />
  )
}
