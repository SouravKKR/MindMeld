
def argument_parser(command_line_args: list[str]):
    result = dict()
    
    for argument in command_line_args:

        arg_pair = argument.split(sep="=")

        
        if len(arg_pair) == 1:
            result[arg_pair[0]] = True 
        else:
            result[arg_pair[0]] = arg_pair[1]

    return result    