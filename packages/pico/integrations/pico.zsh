_pico_shell_widget() {
  local request=$BUFFER
  local generated

  [[ -n ${request//[[:space:]]/} ]] || return 0

  zle -I
  print -r -- "pico --shell ${(qqq)request}"

  if generated=$(command pico --shell "$request"); then
    BUFFER=$generated
    CURSOR=${#BUFFER}
  else
    BUFFER=$request
  fi

  print
  zle reset-prompt
}

zle -N pico-shell _pico_shell_widget
bindkey '^]' pico-shell
